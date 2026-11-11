/**
 * The Govern inventory's box ends on a whole row and says how many rows it holds (ALM Studio Polish 8 T2, ruling 2026-09-29). The inventory reuses
 * the By kind fit through one shared module (layout/wholeRows.ts): its box ends on the bottom edge of the last body row
 * that fits whole under the 560 px cap, and a text line under the table, inside the card, prints the count. Studio tests
 * have no layout engine and effects do not run under the server render, so the arithmetic is pinned with literal
 * inventory-like row heights, the page's use of the hook by its source, and the count line by its markup. The drive
 * measures the cut at 1024, 1280 and 1440 px. Heights, texts and markup are restated here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginCatalogReply } from "@alm/reader";
import { wholeRowsHeight } from "../layout/wholeRows";
import { InventoryView } from "../pages/govern/GovernPages";

const GOVERN = readFileSync(new URL("../pages/govern/GovernPages.tsx", import.meta.url), "utf8");
const BYKIND = readFileSync(new URL("../pages/assumptions/ByKindPage.tsx", import.meta.url), "utf8");

// n catalog components with no role, purpose or ports: one body row each.
const reply = (n: number) => ({
  components: Array.from({ length: n }, (_, i) => ({ id: `alm-c${i}`, kind: "measure", label: `C${i}`, consumes: [], produces: [] })),
  stageKinds: [],
  mounted: [],
}) as unknown as PluginCatalogReply;

describe("the inventory box's height, with rows of differing heights", () => {
  it("ends on the last row that fits whole under 560 px", () => {
    // Header 35, then 112, 150 and 98 to 395; the next row, 175, would end at 570.
    expect(wholeRowsHeight(35, [112, 150, 98, 175, 120], 560)).toBe(395);
    // A short last row after a tall one is not pulled in out of order: 35 + 300 = 335, then 240 would end at 575.
    expect(wholeRowsHeight(35, [300, 240, 20], 560)).toBe(335);
    // A first row taller than the room keeps the cap.
    expect(wholeRowsHeight(35, [540, 90], 560)).toBe(560);
  });
});

describe("the Govern inventory's box and count (Polish 8 T2)", () => {
  it("fits its box through the shared whole-row hook, on the rows it prints", () => {
    expect(GOVERN).toContain('import { useWholeRows } from "../../layout/wholeRows";');
    expect(GOVERN).toContain("const rows = useMemo(() => inventoryRows(props.reply), [props.reply]);");
    expect(GOVERN).toContain("useWholeRows(wrap, rows);");
    expect(GOVERN).toContain('<div className="table-wrap" ref={wrap}><table className="table inventory">');
    // One shared module: neither page holds an observer of its own.
    expect(GOVERN).not.toContain("ResizeObserver");
    expect(BYKIND).not.toContain("ResizeObserver");
    expect(BYKIND).toContain("useWholeRows(wrap, model);");
  });
  it("prints the count as one text line under the table, inside the card, above the source; the server render is unstyled", () => {
    const html = renderToStaticMarkup(<InventoryView reply={reply(71)} />);
    expect(html.match(/<tr>/g)?.length).toBe(72); // the header row and 71 body rows
    expect(html).toContain('<div class="table-wrap"><table class="table inventory">');
    expect(html).toContain('</table></div><p class="table-foot">71 components</p><p class="card-foot">Source: /api/catalog/plugins components[] and mounted[]; the route carries no model version.</p></section>');
  });
  it("says 1 component for one", () => {
    const html = renderToStaticMarkup(<InventoryView reply={reply(1)} />);
    expect(html).toContain('</table></div><p class="table-foot">1 component</p><p class="card-foot">');
    expect(html).not.toContain("1 components");
  });
});
