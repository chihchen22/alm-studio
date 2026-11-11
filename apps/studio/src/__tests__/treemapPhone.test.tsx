/**
 * Treemap cells carry their share of the largest cell (ALM Studio phone 1 Task 2): up to 900px the phone block in
 * app.css lays the cells out as a ranked list of bars, each as long as --share. Above 900px nothing reads it.
 * Expected shares are worked by hand.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Treemap } from "../charts/TreemapChart";

describe("Treemap --share", () => {
  it("is 100% for the largest cell and the rest in proportion, in the layout's order, largest first", () => {
    const html = renderToStaticMarkup(
      <Treemap items={[{ key: "a", value: 400 }, { key: "b", value: 100 }, { key: "c", value: 300 }]} labelOf={(k) => k} valueOf={(k) => k} width={1000} height={240} />,
    );
    // 400 / 400, 300 / 400 and 100 / 400.
    expect([...html.matchAll(/--share:([0-9.]+%)/g)].map((m) => m[1])).toEqual(["100%", "75%", "25%"]);
  });
});
