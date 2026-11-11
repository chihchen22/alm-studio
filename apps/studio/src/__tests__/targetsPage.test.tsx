// apps/studio/src/__tests__/targetsPage.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "@alm/reader";
import { bodyShown, nextSaved, planLoadError, saveIdFor, savedProps, TargetsEditor, TargetsPageView, TargetsView } from "../pages/balance/TargetsPage";
import { familyRows } from "../balance/targetsModel";

const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const base = {
  bookId: "vanilla-book-v1",
  asOf: "2026-03-31",
  plans: [{ id: "bp-a", contentHash: "h", label: "A", asOf: "2026-03-31" }, { id: "bp-old", contentHash: "h", label: "Old", asOf: "2025-12-31" }],
  selected: null as string | null,
  rows: familyRows([{ key: "cash", totalNotional: 150_000_000 }, { key: "fhlb", totalNotional: null }], null),
  label: "",
  saveId: "bp-vanilla-book-v1-edit-1",
  problems: [] as string[],
  saveMsg: null as string | null,
  busy: null as string | null,
  loadError: null as string | null,
  onPick() {}, onRow() {}, onLabel() {}, onSave() {},
};

describe("TargetsView", () => {
  it("lists only balance plans with the book's as-of, plus New", () => {
    const html = renderToStaticMarkup(<TargetsView {...base} />);
    expect(html).toContain(">New balance plan<");
    expect(html).toContain("bp-a");
    expect(html).not.toContain("bp-old");
  });

  it("opens each family row on a row header (Row header scope 2)", () => {
    const html = renderToStaticMarkup(<TargetsView {...base} />);
    expect(html).toContain('<tr><th scope="row" class="mono">cash</th><td class="num">');
    expect(html).toContain('<tr><th scope="row" class="mono">fhlb</th><td class="num">');
  });
  it("prints each family's served opening balance in full USD, and Unobservable when none is served", () => {
    const t = text(renderToStaticMarkup(<TargetsView {...base} />));
    expect(t).toContain("cash 150,000,000");
    expect(t).toContain("fhlb Unobservable: no opening balance served");
  });
  it("states that new business feeds NII only", () => {
    expect(text(renderToStaticMarkup(<TargetsView {...base} />))).toContain("New business feeds NII only. EVE and the gaps run the book off.");
  });
  it("shows the save id on the button and the form problems instead of saving", () => {
    const t = text(renderToStaticMarkup(<TargetsView {...base} problems={["cash: the term must be a whole number of months, 1 or more."]} />));
    expect(t).toContain("Save as bp-vanilla-book-v1-edit-1");
    expect(t).toContain("cash: the term must be a whole number of months, 1 or more.");
  });
  it("a Reach balance that parses shows its grouped read-back beside the input, formatting only", () => {
    const rows = familyRows([{ key: "fixed-loans", totalNotional: 650_000_000 }], null).map((r) => ({ ...r, kind: "reach" as const, balance: "700000000", month: "24" }));
    const t = text(renderToStaticMarkup(<TargetsView {...base} rows={rows} />));
    expect(t).toContain("= 700,000,000");
    for (const typed of ["", "7OO", "abc"]) {
      const bad = rows.map((r) => ({ ...r, balance: typed }));
      expect(text(renderToStaticMarkup(<TargetsView {...base} rows={bad} />))).not.toContain("= ");
    }
  });
  it("cells a target does not use say so in words, never blank, one cell per column, each on its column's right edge (Polish 6 T4)", () => {
    const [cash, fhlb] = familyRows([{ key: "cash", totalNotional: 150_000_000 }, { key: "fhlb", totalNotional: 720_000_000 }], null);
    const rows = [{ ...cash!, kind: "flat" as const, spreadBp: "100", termMonths: "12" }, fhlb!];
    const html = renderToStaticMarkup(<TargetsView {...base} rows={rows} />);
    const t = text(html);
    expect(t).toContain("Held at opening Every month");
    expect(t).toContain("fhlb 720,000,000 Run off Hold flat Reach No new business Not used Not used Not used");
    // The balance tables' absence cell: the body face, the muted ink, one line, right-aligned under a num header.
    expect(html).toContain('<td class="num muted">Held at opening</td><td class="num muted">Every month</td>');
    expect(html).toContain('<td class="num muted">No new business</td><td class="num muted">Not used</td><td class="num muted">Not used</td><td class="num muted">Not used</td></tr>');
    expect(html).not.toMatch(/<td[^>]*colSpan/);
    expect(html).not.toMatch(/<td class="num"><\/td>/);
  });
});

describe("TargetsEditor after a save", () => {
  it("keeps the saved plan selected in the picker and says Saved <id>", () => {
    const html = renderToStaticMarkup(
      <TargetsEditor bookId="vanilla-book-v1" asOf="2026-03-31" plans={base.plans} groups={[{ key: "cash", totalNotional: 150_000_000 }]}
        initialSelected="bp-a" initialMsg="Saved bp-a" onSaved={() => {}} />,
    );
    expect(html).toContain('<option value="bp-a" selected="">');
    expect(text(html)).toContain("Saved bp-a");
    expect(html).not.toContain('<option value="" selected="">');
  });
});

describe("TargetsPage saved state across a Book pill change (I1)", () => {
  const editor = (bookId: string, saved: { bookId: string; id: string } | null) => renderToStaticMarkup(
    <TargetsEditor bookId={bookId} asOf="2026-03-31" plans={base.plans} groups={[{ key: "cash", totalNotional: 150_000_000 }]}
      {...savedProps(saved, bookId)} onSaved={() => {}} />,
  );
  it("a save on book X is not carried into book Y: the picker is back on New balance plan with no Saved line", () => {
    const html = editor("book-y", { bookId: "book-x", id: "bp-a" });
    expect(html).toContain('<option value="" selected="">New balance plan</option>');
    expect(html).not.toContain('<option value="bp-a" selected="">');
    expect(text(html)).not.toContain("Saved");
  });
  it("on the same book the saved plan stays selected with Saved <id>", () => {
    const html = editor("book-x", { bookId: "book-x", id: "bp-a" });
    expect(html).toContain('<option value="bp-a" selected="">');
    expect(text(html)).toContain("Saved bp-a");
  });
  it("with nothing saved the picker is on New balance plan", () => {
    expect(savedProps(null, "book-x")).toEqual({ initialSelected: null, initialMsg: null });
  });
});

describe("the saved note across a Book pill round trip (Polish 1 T1)", () => {
  const s = { bookId: "book-x", id: "bp-a" };
  it("clears on any book change, so returning to the book shows no Saved line", () => {
    expect(nextSaved(s, "book-x", "book-y")).toBeNull();
    expect(nextSaved(s, "book-y", "book-x")).toBeNull();
    expect(nextSaved(s, "book-x", null)).toBeNull();
  });
  it("stays while the book is unchanged", () => {
    expect(nextSaved(s, "book-x", "book-x")).toBe(s);
    expect(nextSaved(null, "book-x", "book-x")).toBeNull();
  });
});

describe("busy while a plan loads or saves (Polish 1 T2)", () => {
  it("a busy view says so, and Save and every row input are off", () => {
    const rows = familyRows([{ key: "cash", totalNotional: 150_000_000 }], null).map((r) => ({ ...r, kind: "reach" as const, balance: "1", month: "2" }));
    const html = renderToStaticMarkup(<TargetsView {...base} rows={rows} busy="Reading balance plan bp-a" />);
    // Off by aria-disabled, not disabled, so a focused Save keeps focus through the save and the re-read (final review M4).
    expect(html).toContain('<button type="button" class="btn btn-primary" aria-disabled="true">Save as');
    expect(html).not.toContain('<button type="button" class="btn btn-primary" disabled="">');
    expect(text(html)).toContain("Reading balance plan bp-a");
    expect(html).toMatch(/<select aria-label="Target for cash" disabled="">/);
    expect(html).toMatch(/<input class="input input-bal" aria-label="Balance, USD, cash" inputMode="decimal" disabled="" value="1"\/>/);
    // The Label is off with the rows, so a loading plan cannot overwrite what is typed (Task 8 fix I5).
    expect(html).toContain('<input class="input" aria-label="Label" disabled="" value=""/>');
  });
  it("an idle view keeps Save on", () => {
    expect(renderToStaticMarkup(<TargetsView {...base} />)).toContain('<button type="button" class="btn btn-primary">Save as');
  });
  it("the editor is busy while a picked plan's body is read (the first render, before the read lands)", () => {
    const picked = renderToStaticMarkup(
      <TargetsEditor bookId="vanilla-book-v1" asOf="2026-03-31" plans={base.plans} groups={[{ key: "cash", totalNotional: 150_000_000 }]} initialSelected="bp-a" onSaved={() => {}} />,
    );
    expect(text(picked)).toContain("Reading balance plan bp-a");
    expect(picked).toContain('<button type="button" class="btn btn-primary" aria-disabled="true">Save as');
    const fresh = renderToStaticMarkup(
      <TargetsEditor bookId="vanilla-book-v1" asOf="2026-03-31" plans={base.plans} groups={[{ key: "cash", totalNotional: 150_000_000 }]} onSaved={() => {}} />,
    );
    expect(text(fresh)).not.toContain("Reading balance plan");
    expect(fresh).toContain('<button type="button" class="btn btn-primary">Save as');
  });
});

describe("a failed plan load keeps the picker (Polish 1 T3)", () => {
  it("prints the error under the toolbar as an Unobservable panel, keeps the picker, shows no rows or previous label, and turns Save off", () => {
    const html = renderToStaticMarkup(<TargetsView {...base} selected="bp-a" label="bp-previous" loadError={'balance plan "bp-a" not found'} problems={["cash: the term must be a whole number of months, 1 or more."]} />);
    // The problems of the plan shown before do not stay beside the failure (final review M5).
    expect(html).not.toContain("plan-banner");
    expect(html).not.toContain("the term must be a whole number");
    expect(html).toContain('aria-label="Balance plan"');
    expect(html).toContain('<section class="card unobs-panel" role="alert"><span class="status status-unobs">Balance plan not read</span><p class="unobs-text">balance plan &quot;bp-a&quot; not found</p></section>');
    // No rows and no previous plan's values beside the failure (Task 8 fix T3).
    expect(html).not.toContain('aria-label="Targets"');
    expect(html).not.toContain("Target for cash");
    expect(html).not.toContain("bp-previous");
    expect(html).toContain('<input class="input" aria-label="Label" disabled="" value=""/>');
    expect(html).toContain('<button type="button" class="btn btn-primary" disabled="">Save as');
  });
  it("the failure prints the server's sentence, not its status and code (Task 8 fix I1)", () => {
    expect(planLoadError({ state: "error", error: new ApiError(404, "not-found", 'balance plan "x" not found') })).toBe('balance plan "x" not found');
    expect(planLoadError({ state: "error", error: new TypeError("Failed to fetch") })).toBe("The platform could not be reached. Is it running?");
    expect(planLoadError({ state: "loading" })).toBeNull();
    expect(planLoadError({ state: "ok", value: null })).toBeNull();
  });
});

describe("no blank flash after a save (Polish 1 T2, ruling B2)", () => {
  const kept = { bookId: "book-x", asOf: "2026-03-31", plans: base.plans, groups: [{ key: "cash", totalNotional: 150_000_000 }] };
  const next = { bookId: "book-x", asOf: "2026-03-31", plans: [], groups: [{ key: "cash", totalNotional: 160_000_000 }] };
  it("keeps the last body while a refresh of the same book loads", () => {
    expect(bodyShown(kept, { state: "loading" }, "book-x")).toBe(kept);
  });
  it("switches to the new body when it lands", () => {
    expect(bodyShown(kept, { state: "ok", value: next }, "book-x")).toBe(next);
  });
  it("keeps nothing once the book changes, and never shows another book's landed body", () => {
    expect(bodyShown(kept, { state: "loading" }, "book-y")).toBeNull();
    expect(bodyShown(null, { state: "loading" }, "book-x")).toBeNull();
    expect(bodyShown(kept, { state: "ok", value: next }, "book-y")).toBeNull();
    expect(bodyShown(kept, { state: "error", error: new Error("down") }, "book-x")).toBeNull();
  });
  it("the page shows the kept rows while refreshing, not Reading book", () => {
    const html = renderToStaticMarkup(
      <TargetsPageView bookId="book-x" load={{ state: "loading" }} shown={bodyShown(kept, { state: "loading" }, "book-x")} saved={null} onSaved={() => {}} />,
    );
    expect(text(html)).toContain("cash 150,000,000");
    expect(text(html)).not.toContain("Reading book");
  });
  it("with nothing kept the page says Reading book <id>", () => {
    const html = renderToStaticMarkup(<TargetsPageView bookId="book-x" load={{ state: "loading" }} shown={null} saved={null} onSaved={() => {}} />);
    expect(text(html)).toBe("Reading book book-x");
  });
});

describe("a just-saved plan not yet listed stays selected (Polish 1 T2, ruling on concern 1)", () => {
  it("renders the selected id as the selected option, and New balance plan is not selected", () => {
    const html = renderToStaticMarkup(<TargetsView {...base} selected="bp-vanilla-book-v1-edit-1" />);
    expect(html).toContain('<option value="bp-vanilla-book-v1-edit-1" selected="">bp-vanilla-book-v1-edit-1</option>');
    expect(html).toContain('<option value="">New balance plan</option>');
    expect(html).not.toContain('<option value="" selected="">');
  });
  it("a listed selection is not printed twice", () => {
    const html = renderToStaticMarkup(<TargetsView {...base} selected="bp-a" />);
    expect(html.match(/<option value="bp-a"/g)).toHaveLength(1);
  });
});

describe("the next save id after a save, before the re-read list holds it (Polish 1 T2, review fix round 1)", () => {
  it("is never the id just saved", () => {
    expect(saveIdFor("bp-vanilla-book-v1-edit-1", "vanilla-book-v1", base.plans)).toBe("bp-vanilla-book-v1-edit-2");
    expect(saveIdFor(null, "vanilla-book-v1", base.plans)).toBe("bp-vanilla-book-v1-edit-1");
    expect(saveIdFor("bp-a", "vanilla-book-v1", base.plans)).toBe("bp-a-edit-1");
  });
  it("the editor's Save names the next id, not the just-saved one", () => {
    const html = renderToStaticMarkup(
      <TargetsEditor bookId="vanilla-book-v1" asOf="2026-03-31" plans={base.plans} groups={[{ key: "cash", totalNotional: 150_000_000 }]} initialSelected="bp-vanilla-book-v1-edit-1" onSaved={() => {}} />,
    );
    expect(text(html)).toContain("Save as bp-vanilla-book-v1-edit-2");
    expect(text(html)).not.toContain("Save as bp-vanilla-book-v1-edit-1");
  });
});
