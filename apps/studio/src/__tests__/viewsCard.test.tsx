// apps/studio/src/__tests__/viewsCard.test.tsx
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ViewsCard } from "../pages/plan/ViewsCard";
import type { ViewDimOption } from "../plan/planViews";

const FUNDING = "liquidity-funding-demo-v1.funding";
const BUCKET = "liquidity-funding-demo-v1.bucket";
const VIEW = { id: "view-1", label: "Funding then bucket", groupBy: [FUNDING, BUCKET] };

// The six ids the seeded liability copy offers, restated here, in the engine's order.
const COPY_IDS = ["hqla-level", "lcr-category", FUNDING, BUCKET, "productFamily", "side"];
const COPY_OPTIONS: ViewDimOption[] = COPY_IDS.map((id) => ({
  id,
  label: id === "productFamily" ? "Product family (derived)" : id === "side" ? "Side (derived)" : id,
  derived: id === "productFamily" || id === "side",
}));
const NOTE = "synthetic-lcr-liabilities-v1 and 1 re-tagged copy";

const noop = () => undefined;
function card(over: Partial<Parameters<typeof ViewsCard>[0]> = {}): string {
  return renderToStaticMarkup(
    <ViewsCard
      views={[VIEW]}
      bookId="synthetic-lcr-liabilities-v1--liquidity-funding-demo-v1"
      options={COPY_OPTIONS}
      optionsError={null}
      note={NOTE}
      draft={{ label: "", picks: [] }}
      nextId="view-2"
      onDraft={noop}
      onAdd={noop}
      onRemove={noop}
      {...over}
    />,
  );
}

/** The option values of the Group by select, in order. */
function groupByValues(html: string): string[] {
  const sel = /<select[^>]*aria-label="Group by"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  if (sel === null) return [];
  return [...sel[1]!.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]!);
}

/** The opening tag of the button whose text starts with the given label. */
function buttonTag(html: string, text: string): string {
  const m = new RegExp(`<button[^>]*>${text}`).exec(html);
  if (m === null) throw new Error(`no button "${text}" in ${html}`);
  return m[0];
}

describe("ViewsCard", () => {
  it("lists each view with its label, id and grouping, and one Remove button", () => {
    const html = card();
    expect(html).toContain("Funding then bucket");
    expect(html).toContain("view-1");
    expect(html).toContain("liquidity-funding-demo-v1.funding then liquidity-funding-demo-v1.bucket");
    expect(html.match(/>Remove</g)).toHaveLength(1);
    expect(html).toContain("Views");
  });

  it("offers exactly the options it is given, in order, and never behavioralClasses", () => {
    const html = card({ views: [] });
    expect(groupByValues(html)).toEqual(COPY_IDS);
    expect(html).not.toContain("behavioralClasses");
    expect(html).toContain("Side (derived) (side)");
  });

  it("disables Add view until the draft has a label and a dimension, and hides picked ids from the select", () => {
    const empty = card({ draft: { label: "", picks: [] } });
    expect(buttonTag(empty, "Add view")).toContain('disabled=""');
    const ready = card({ draft: { label: "x", picks: ["side"] } });
    expect(buttonTag(ready, "Add view")).not.toContain("disabled");
    expect(ready).toContain("Groups by: ");
    expect(groupByValues(ready)).toEqual(["hqla-level", "lcr-category", FUNDING, BUCKET, "productFamily"]);
    expect(buttonTag(card({ draft: { label: "", picks: ["side"] } }), "Add view")).toContain('disabled=""');
    expect(buttonTag(card({ draft: { label: "x", picks: [] } }), "Add view")).toContain('disabled=""');
    expect(card({ nextId: "view-2" })).toContain("view-2");
  });

  it("prints the picked dimensions as a chain with a Clear button", () => {
    const html = card({ draft: { label: "x", picks: ["productFamily", "side"] } });
    expect(html).toContain("Groups by: ");
    expect(html).toContain("productFamily then side");
    expect(html).toContain(">Clear<");
  });

  it("says no dimension is offered when the book could not be read, and still lists the views", () => {
    const html = card({
      bookId: "synthetic-2500-v1",
      options: null,
      optionsError: "404: no such book",
    });
    expect(html).toContain("No dimension offered: book synthetic-2500-v1 could not be read.");
    expect(html).toContain("404: no such book");
    expect(html).not.toContain("<select");
    expect(html).toContain("Funding then bucket");
  });

  it("says so when the plan declares no view", () => {
    expect(card({ views: [] })).toContain("No view declared on this plan.");
    expect(card()).not.toContain("No view declared on this plan.");
  });

  it("holds the book note and the validate sentences in the foot, with no not-yet wording", () => {
    const html = card();
    expect(html).toContain(NOTE);
    expect(html).toContain("Offered: the single-valued tags");
    expect(html).toContain("P1 and P2");
    expect(html).toContain("(P3)");
    expect(html).toContain("A run of the saved plan carries its views, and the Results Views tab groups the run by each one.");
    expect(html).toContain("Source: /api/portfolios/synthetic-lcr-liabilities-v1--liquidity-funding-demo-v1 taxonomy; /api/portfolios; /api/hierarchies.");
    expect(html).not.toContain("does not carry");
    expect(html).not.toMatch(/\byet\b/);
  });
});
