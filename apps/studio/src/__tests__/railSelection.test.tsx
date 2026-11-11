/**
 * The result picker's choice travels between Results screens (spec v3.1 Section 5.4, final review M6). The rail and
 * the phone sheet build their links with `selectionQuery`, so `?result=` rides from NII to EVE and is dropped on the
 * way out of Results. Studio tests have no DOM: the markup is the server render; the hrefs are restated by hand.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Rail } from "../shell/Rail";
import { TopBar } from "../shell/TopBar";
import { HEAD } from "./fixtures/workspace";

const onNii = { kind: "screen" as const, ws: "ws-synthetic-2500-v1", section: "results" as const, screen: "nii" as const, query: { result: "run-0042", window: "24" } };

describe("the result choice on rail and sheet links", () => {
  it("a rail link from NII to EVE keeps ?result= and nothing else", () => {
    const html = renderToStaticMarkup(<Rail route={onNii} head={HEAD} />);
    expect(html).toContain('href="#/ws/ws-synthetic-2500-v1/results/eve?result=run-0042"');
    expect(html).not.toContain("window=24");
  });
  it("the phone sheet keeps ?result= inside Results and drops it on a link out of Results", () => {
    const html = renderToStaticMarkup(<TopBar route={onNii} head={HEAD} workspaces={[HEAD]} ctxOpen={true} onCtx={() => {}} />);
    expect(html).toContain('class="section-sheet-item" href="#/ws/ws-synthetic-2500-v1/results/eve?result=run-0042"');
    expect(html).toContain('class="section-sheet-item" href="#/ws/ws-synthetic-2500-v1/market/curves"');
    expect(html).not.toMatch(/market\/curves\?result=/);
  });
  it("the section bar carries the choice to Results and drops it elsewhere", () => {
    const html = renderToStaticMarkup(<TopBar route={onNii} head={HEAD} workspaces={[HEAD]} ctxOpen={false} onCtx={() => {}} />);
    expect(html).toContain('class="mod" href="#/ws/ws-synthetic-2500-v1/results/dashboard?result=run-0042"');
    expect(html).toContain('class="mod" href="#/ws/ws-synthetic-2500-v1/govern/lineage"');
  });
});
