// apps/studio/src/__tests__/resultsInstruments.test.tsx
// The Instruments tab. Expected figures are restated from the fixture's
// inputs (notional x 0.98 for the base PV, x 0.95 under S200, NII 5 percent of notional, +1 and -1 percent under the shocks).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError, NOT_IN_RUN } from "@alm/reader";
import type { InstrumentsFile, RunResult } from "@alm/engine";
import { beforeParNote, INSTRUMENT_ROW_CAP, InstrumentsLoadFailure, InstrumentsTab, InstrumentsView } from "../pages/results/InstrumentsTab";
import { BLOCKS_DETAIL, blocksResult, instrumentsFixture } from "./fixtures/blocks";
import { freshResult } from "./fixtures/results";

const view = (query: Record<string, string> = {}, file: InstrumentsFile = instrumentsFixture()) =>
  renderToStaticMarkup(<InstrumentsView ws="ws-a" runId="run-fixture" detail={BLOCKS_DETAIL} file={file} query={query} />);

const order = (html: string, ids: string[]): string[] =>
  ids.map((id) => ({ id, at: html.indexOf(`>${id}</a>`) })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at).map((x) => x.id);

const IDS = ["small-loan", "big-loan", "mid-loan", "hys-a-core-1", "hys-a-noncore"];

describe("InstrumentsView", () => {
  it("sorts by notional, largest first, by default", () => {
    expect(order(view(), IDS)).toEqual(["big-loan", "hys-a-core-1", "hys-a-noncore", "mid-loan", "small-loan"]);
  });

  it("reverses on dir=asc and sorts by position id on sort=id", () => {
    expect(order(view({ dir: "asc" }), IDS)).toEqual(["small-loan", "mid-loan", "hys-a-noncore", "hys-a-core-1", "big-loan"]);
    expect(order(view({ sort: "id", dir: "asc" }), IDS)).toEqual(["big-loan", "hys-a-core-1", "hys-a-noncore", "mid-loan", "small-loan"]);
  });

  it("filters by family", () => {
    const html = view({ family: "hys-a" });
    expect(order(html, IDS)).toEqual(["hys-a-core-1", "hys-a-noncore"]);
    expect(html).toContain("Showing 2 of 5 positions");
  });

  it("filters by a dimension key and value, and offers the keys and then the values as chips", () => {
    const keys = view();
    expect(keys).toContain('aria-label="Dimension"');
    expect(keys).toContain(">segment</a>");
    const values = view({ dim: "segment" });
    expect(values).toContain('aria-label="Dimension value"');
    expect(values).toContain(">corporate</a>");
    expect(values).toContain(">retail</a>");
    const one = view({ dim: "segment", val: "corporate" });
    expect(order(one, IDS)).toEqual(["big-loan"]);
    expect(one).toContain("Showing 1 of 5 positions");
  });

  it("prints the base PV and the PV under the selected scenario", () => {
    const base = view();
    // big-loan: 900M x 0.98 = 882.0M base; 900M x 0.95 = 855.0M under S200.
    expect(base).toContain("$882.0M");
    expect(base).not.toContain("$855.0M");
    const s200 = view({ scenario: "S200" });
    expect(s200).toContain("$882.0M");
    expect(s200).toContain("$855.0M");
    expect(s200).toContain("PV, S200");
  });

  it("prints the constant-balance NII at base and its change under plus and minus 200bp, and the SEG peak", () => {
    const html = view();
    // big-loan: base 45.0M, +9.0M, -9.0M; SEG peak 810.0M.
    expect(html).toContain("$45.0M");
    expect(html).toContain("+$9.0M");
    expect(html).toContain("−$9.0M");
    expect(html).toContain("$810.0M");
    expect(html).toContain("NII 12m, +200bp vs base");
  });

  it("leaves the seg columns out when no row carries the seg scalars", () => {
    const file = instrumentsFixture();
    for (const p of file.positions) delete p.seg;
    const html = view({}, file);
    expect(html).not.toContain("NII 12m, +200bp vs base");
    expect(html).not.toContain("SEG peak");
  });

  it("says so where a position has no WAL, rather than printing zero", () => {
    const html = view({ family: "hys-a" });
    expect(html).toContain("none");
    expect(html).toContain("no principal inside the horizon");
  });

  it("prints a child's parent and a first repricing month, and none where the position never reprices", () => {
    const html = view({ family: "hys-a" });
    expect(html).toContain("parent hys-a");
    const loan = view({ dim: "segment", val: "corporate" });
    expect(loan).toContain("never");
  });

  it("links the CSV download to the route and each position to the instrument drawer", () => {
    const html = view();
    expect(html).toContain('href="/api/runs/run-fixture/instruments.csv"');
    expect(html).toContain("download");
    expect(html).toContain("position=big-loan");
    expect(html).not.toContain('aria-label="Instrument big-loan"');
  });

  it("opens the existing instrument drawer on position=, against the run's book and market", () => {
    const html = view({ position: "big-loan" });
    expect(html).toContain('aria-label="Instrument big-loan"');
    expect(html).toContain("Close");
  });

  it("caps the grid and says how many rows it shows", () => {
    const file = instrumentsFixture();
    const base = file.positions[0]!;
    file.positions = Array.from({ length: INSTRUMENT_ROW_CAP + 50 }, (_, i) => ({ ...base, positionId: `p-${i}`, notional: 1_000 + i }));
    const html = view({}, file);
    expect(html.match(/<th scope="row"/g)?.length).toBe(INSTRUMENT_ROW_CAP);
    expect(html).toContain(`Showing ${INSTRUMENT_ROW_CAP} of ${INSTRUMENT_ROW_CAP + 50} positions`);
    expect(html).toContain("download the CSV");
  });

  it("every body row opens on a row header", () => {
    const bodies = [...view().matchAll(/<tbody>([\s\S]*?)<\/tbody>/g)].map((m) => m[1]!);
    const firsts = bodies.flatMap((b) => [...b.matchAll(/<tr[^>]*>(<t[dh][^>]*>)/g)].map((m) => m[1]!));
    expect(firsts.length).toBe(5);
    expect(firsts.filter((c) => !c.startsWith('<th scope="row"'))).toEqual([]);
  });
});

describe("InstrumentsTab", () => {
  const props = (result: RunResult, query: Record<string, string> = {}) => ({ runId: "run-fixture", detail: BLOCKS_DETAIL, result, query, scenarioLabel: (id: string) => id });

  // The server never writes RunResult.instrumentsFile (the pass leaves result.json byte-identical), so the tab cannot
  // gate on the pointer: it reads the file and takes the route's 404 as "not in this run". Found in the live walk.
  it("a run whose envelope carries no pointer still reads the file, because the server never writes the pointer", () => {
    const out = renderToStaticMarkup(<InstrumentsTab ws="ws-a" {...props(freshResult())} />);
    expect(out).toContain("Reading the per-position results");
    expect(out).not.toContain(NOT_IN_RUN);
  });

  it("a run whose envelope does carry a pointer is read the same way, because the tab ignores it", () => {
    const withPointer = blocksResult();
    expect(withPointer.instrumentsFile).toBeDefined();
    expect(freshResult().instrumentsFile).toBeUndefined();
    const a = renderToStaticMarkup(<InstrumentsTab ws="ws-a" {...props(withPointer)} />);
    const b = renderToStaticMarkup(<InstrumentsTab ws="ws-a" {...props(freshResult())} />);
    expect(a).toBe(b);
  });
});

describe("InstrumentsLoadFailure", () => {
  it("a 404 from the route is not in this run, with one sentence naming the switch", () => {
    const out = renderToStaticMarkup(<InstrumentsLoadFailure error={new ApiError(404, "not-found", 'run "r" has no per-position results file')} />);
    expect(out).toContain(NOT_IN_RUN);
    expect(out).toContain("did not save per-position results");
    expect(out).toContain("Store instrument results");
  });

  it("any other failure is an alert carrying the server's words, not a not-in-run panel", () => {
    const out = renderToStaticMarkup(<InstrumentsLoadFailure error={new ApiError(500, "internal", "the file could not be read")} />);
    expect(out).toContain('role="alert"');
    expect(out).toContain("the file could not be read");
    expect(out).not.toContain(NOT_IN_RUN);
  });
});

describe("a results file made before balances held at book were valued at par (Spec P1)", () => {
  const withHeldAtBook = (version: string): InstrumentsFile => {
    const f = instrumentsFixture();
    const first = f.positions[0]!;
    const held = { ...first, positionId: "cash-due", familyId: "non-earning", type: "non-rate-sensitive", byScenario: first.byScenario.map((s) => ({ ...s, pv: 0 })) };
    return { ...f, schemaVersion: version as "1.0.0", positions: [...f.positions, held] };
  };

  it("says in one line that a 1.0.0 file reads 0 for them", () => {
    const html = view({}, withHeldAtBook("1.0.0"));
    expect(html).toContain("This results file was made before balances held at book were valued at par, so their rows read 0.");
    expect((html.match(/role="note"/g) ?? []).length).toBe(1);
  });

  it("says nothing on a 1.1.0 file, or on a 1.0.0 file with no balance held at book", () => {
    expect(beforeParNote(withHeldAtBook("1.1.0"))).toBeNull();
    expect(beforeParNote(instrumentsFixture())).toBeNull();
    expect(view({}, withHeldAtBook("1.1.0"))).not.toContain("valued at par");
  });
});
