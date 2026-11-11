/**
 * The 3D surface's markup and its one new token (ALM Studio Polish 10 T3). The canvas draws in the browser (the drive
 * checks it in both themes); here the canvas's label, its 440 px height, the four view buttons and the --shade token
 * in all three theme blocks are read. Expected texts are restated.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { VolGrid } from "@alm/reader";
import { Surface3D } from "../charts/Surface3D";

const TOKENS = readFileSync(new URL("../../design/tokens.css", import.meta.url), "utf8");
const APP_CSS = readFileSync(new URL("../styles/app.css", import.meta.url), "utf8");
// Normal vols in bp at the public pack's cap-analog grid points (packages/kernel/public/market_public.json).
const GRID: VolGrid = { rows: [1, 2], cols: [0.03, 0.04], cells: [[70.25, 66.65], [68.04, 63.69]], atm: [63.45, null], min: 63.45, max: 70.25 };
const noop = () => undefined;

function surface(pinned = false) {
  return renderToStaticMarkup(
    <Surface3D grid={GRID} xKind="linear" xName="Strike" colTicks={GRID.cols} colAxis={(k) => `${k * 100}%`} colFormat={(k) => `${(k * 100).toFixed(2)}%`} colNoun="strike"
      rowFormat={(r) => `${r}y`} sel={{ i: 1, j: 1 }} pinned={pinned} onHover={noop} onPin={noop} label="Cap normal vol surface, 2 expiries by 2 strikes, 4 stored quotes" />,
  );
}

describe("Surface3D", () => {
  it("draws on a 440 px canvas named for the surface and its quote count", () => {
    expect(surface()).toContain('<canvas class="s3-canvas" height="440" role="img" aria-label="Cap normal vol surface, 2 expiries by 2 strikes, 4 stored quotes"></canvas>');
  });
  it("offers four views, 3D pressed first", () => {
    expect(surface()).toContain('<div class="seg s3-views" role="group" aria-label="View"><button type="button" aria-pressed="true">3D</button><button type="button" aria-pressed="false">Front</button><button type="button" aria-pressed="false">Side</button><button type="button" aria-pressed="false">Top</button></div>');
  });
  it("shows no tooltip until the pointer is on a quote", () => {
    expect(surface()).not.toContain("lp-tip");
  });
  it("sizes the canvas to the card's width and 440 px, the grab cursor on it", () => {
    expect(APP_CSS).toContain(".s3-canvas { display: block; width: 100%; height: 440px; cursor: grab; touch-action: none; border-radius: var(--r-2); }");
  });
});

describe("the drop line (Polish 10 Task 5, F9)", () => {
  it("draws over a 3 px surface-coloured under-stroke, then the 1 px dash, as the traces are", () => {
    const src = readFileSync(new URL("../charts/Surface3D.tsx", import.meta.url), "utf8");
    const under = src.indexOf("line(foot, top, C.surface, 3);");
    const dash = src.indexOf("line(foot, top, C.ink2, 1, [3, 3]);");
    expect(under).toBeGreaterThan(0);
    expect(dash).toBeGreaterThan(under);
  });
});

describe("the --shade token", () => {
  it("is set in the light block and in both dark blocks", () => {
    const blocks = [/:root \{[^}]*\}/, /:root:not\(\[data-theme="light"\]\) \{[^}]*\}/, /:root\[data-theme="dark"\] \{[^}]*\}/].map((re) => TOKENS.match(re)?.[0] ?? "");
    for (const b of blocks) expect(b).toContain("--shade: #000000;");
  });
});
