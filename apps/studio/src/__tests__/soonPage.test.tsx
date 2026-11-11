// apps/studio/src/__tests__/soonPage.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LAYERS, type LayerDef } from "../router";
import { SoonPage } from "../pages/SoonPage";

describe("Soon page", () => {
  for (const l of LAYERS.filter((x) => x.status === "soon")) {
    it(`${l.id} names its piece and prints no other digit`, () => {
      const text = renderToStaticMarkup(<SoonPage layer={l} />).replace(/<[^>]+>/g, " ");
      expect(text).toContain(`Piece ${l.soon!.piece}`);
      expect(text).toContain(l.label);
      expect(text.replace(`Piece ${l.soon!.piece}`, "")).not.toMatch(/\d/);
    });
  }
  // Re-expectation: Macro factors is live; no layer is Soon.
  // The page still renders a placed, unbuilt layer: a synthetic one, written out here since mfu-3 removed the
  // router's unused soon helper (final-review Minor 1, ruling R-b).
  it("no layer is Soon, and a synthetic Soon layer names its piece and prints no other digit", () => {
    expect(LAYERS.filter((x) => x.status === "soon")).toEqual([]);
    expect(readFileSync(fileURLToPath(new URL("../router.ts", import.meta.url)), "utf8")).not.toContain("export const soon");
    const l: LayerDef = { id: "data/market/curves", module: "data", area: "Market", label: "Placed layer", status: "soon", soon: { piece: 9, will: "Will hold a thing.", gap: "Nothing holds it today." } };
    const text = renderToStaticMarkup(<SoonPage layer={l} />).replace(/<[^>]+>/g, " ");
    expect(text).toContain("Piece 9");
    expect(text).toContain("Placed layer");
    expect(text.replace("Piece 9", "")).not.toMatch(/\d/);
  });
});
