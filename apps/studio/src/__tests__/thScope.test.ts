/**
 * Every table header Studio renders carries a scope (ALM Studio Polish 14 item 1). Polish 9 gave the Govern tables
 * `<th scope="col">`; this sweep holds the rest to the same rule. Every .tsx file under apps/studio/src outside
 * __tests__ is read, and each `<th` opening tag (up to its first `>`) must hold `scope=`: "col" for a column header in a
 * thead, "row" for a header that labels its body row.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "__tests__" ? [] : sources(path);
    return name.endsWith(".tsx") ? [path] : [];
  });
}

/** Each `<th` opening tag in a source text, from `<th` to its first `>`; `<thead` is not one. */
function thTags(text: string): string[] {
  return [...text.matchAll(/<th(?:>|[\s/][^>]*>)/g)].map((m) => m[0]);
}

describe("Studio table headers", () => {
  it("the tag reader finds a bare, a scoped and a self-closing header and skips thead", () => {
    expect(thTags('<thead><tr><th>A</th><th scope="col" className="num">B</th><th /></tr></thead>')).toEqual([
      "<th>", '<th scope="col" className="num">', "<th />",
    ]);
  });

  it("every <th in a non-test .tsx under apps/studio/src carries scope=", () => {
    const files = sources(SRC);
    // The walk reaches the tables it pins: the Govern pages (scoped since Polish 9) and the EVE tab are among the files read.
    expect(files.some((f) => f.endsWith(join("govern", "GovernPages.tsx")))).toBe(true);
    expect(files.some((f) => f.endsWith(join("results", "EveTab.tsx")))).toBe(true);
    const tags = files.flatMap((f) => thTags(readFileSync(f, "utf8")).map((t) => `${f.slice(SRC.length)}: ${t}`));
    // 173 header tags across 26 files: 167 at the Polish 14 branch point (git grep), plus the 6 row headers Polish 15
    // item 1 adds (5 on the EVE tab: the by-scenario and channel scenario cells, the node tenor, the sum and the
    // parallel reference; 1 on Edit-a-set: the month or row number), recounted with grep -o. Row header scope adds 15
    // more: Balance 2 (position id, group key), NII 2 (horizon scenario, shortfall scenario), Metrics 1, Gap 1, FTP 1,
    // Market 1 (consuming run), Rates 1 (scenario), Govern 4 (lineage run, inventory component, audit run, input
    // role), ShockPicture 1 (knot tenor) and the LinePlot Show table 1 (point): 188, recounted with grep -o. Row header
    // scope 2 adds 14 more: Dashboard 1 (scenario), Compare 1 (first key), CoA 1 (node), Targets 1 (family), the
    // instrument drawer's schedule 1 (month), Assumptions 2 (bindings family, diff family), By kind 1 (family),
    // Attribution 1 (family), Lenses 1 (scenario), Overview 1 (scenario), the shock builder 1 (knot), the shock preview
    // 1 (tenor) and BarPairs 1 (category): 202, recounted with grep -o. Controls (limits) adds 10: the Dashboard's
    // Limit use card 4 (Lens, Status, Min headroom columns and the lens row) and the Limits page 6 (Constraint, Reader,
    // Test, Limit, Label columns and the constraint row): 212. Controls (approvals) adds 6: the Approvals page's record table
    // columns (Recorded at, Decision, Artifact, Content hash, Recorded by, Note): 218. Loan repricing adds 1: the projected client rate table's month column: 219.
    // Hierarchies and mapping adds 14: the levels table 5 (Order, Level id, Label, Action columns and the order row header), the nodes table 6 (Order, Node id, Level, Parent, Action and the order row header) and the map table 3 (Source value, Leaf node and the value row header): 233. Behavioral shocks adds 10: the preview table 6 (Binding, Parameter, Unit, Base value, Derived value and the binding row header) and the stored shocks table 4 (Set, Label, Base set and the set row header): 243. Balance shocks adds 14: the preview table 5 (Family, Knot month, Base target, Derived target and the family row header), the After lowering table 4 (Family, Lowers to, Monthly growth rate and the family row header) and the stored shocks table 5 (Plan, Label, Base plan, As of and the plan row header): 257. Funding spread shocks adds 13: the base nodes table 3 (Tenor, Stored spread and the tenor row header), the preview table 5 (Tenor, Base spread, Derived spread, Change (bp) and the tenor row header) and the stored shocks table 5 (Market, Label, Base market, As of and the market row header): 270. Rate indices adds 11: the indices table 5 (Index, Label, Tenor, Basis and the index row header) and the preview table 6 (Index, Tenor, Base basis, Derived basis, Change (bp) and the index row header): 281 (Re-expectation). Volatility shocks adds 14: the base ATM table 3 (Expiry, Stored ATM vol (bp) and the expiry row header), the preview table 6 (Expiry, Base ATM vol (bp), Derived ATM vol (bp), Change (bp), Quotes moved and the expiry row header) and the stored derived markets table 5 (Market, Label, Base market, As of and the market row header): 295 (Re-expectation). Stochastic Compare adds 10: the distribution table (Statistic, Run A, Run B, B - A columns and the statistic row header, in one JSX source row) and the Like for like table (Field, Run A, Run B, Same columns and the field row header): 305. Single-run stochastic view adds 6: the distribution table (Statistic, Value columns and the statistic row header, in one JSX source row) and the Run context table (Field, Value columns and the field row header): 311. Macro factors adds 13: the series table 10 (Series, Label, Kind, Role, Unit, First month, End month, Source, Gaps columns and the series row header) and the preview table 3 (Series, Change columns and the series row header): 324 (Re-expectation). The workspace frame adds 16: the definitions table in Rate indices 5 (Definition, Depends on, Status, Detail and the definition row header), the node targets table in Targets 7 (Node, Balance, By month, Spread, Term, Allocation across templates, Remove) and the Mapping grid 4 (Family, Selector, the kind column and the family row header): 340.
        // ae1-E3 (Workspace Home, New, Overview, Compare) adds 21: the Home list 5, Overview's blocks 2, readiness 5 and history 4, Compare's blocks 5: 361.
        // ae1-E6 (Single instrument) adds 20 th tags in its discounted cash flow tables: 381.
        // ae1-E7 (Results picker, NII window and New business block, Govern workspace cards) adds 29 (ae1): the monthly NII roll-up and month tables, the New business family and monthly originations tables, the workspace history and sign-off log tables: 410.
        // Piece B, B1 (Curve setups) adds 12: the quote grid 8 (Row, Instrument, Tenor, Quote type, Value, Convexity, Remove columns and the row-number row header) and the preview table 4 (Tenor, Zero rate, Discount factor columns and the tenor row header): 422.
        // Piece B, B2 (Derived curves) adds 5: the spread grid's Row, Tenor months, Spread bp and Remove columns and the
        // row-number row header: 427.
        // Piece B, B2 (Rate indices) adds 2: the Derived curve column of the indices table and of the preview table: 429.
    // ADR-038, Task 12 adds 56: SEG / EBP 10 (family table 6 and its row header, the not-covered table 2 and its
    // row header), Liquidity 20 (survival 5, ladder 9 in one JSX source row, stress table 6), Book tie-out 8, Instruments 14
    // (13 columns including the four seg columns and the PV of the picked scenario, and the position row header) and the
    // NII conventions table 4: 485, recounted with grep -o.
    // ADR-038, Task 13 adds 11: the Market curves table 8 (Tenor, Zero, Par, 1-month forward, Discount factor,
    // TLP, All-in columns and the tenor row header) and the setup editor's liquidity stress table 3 (the scenario column,
    // the four rate columns in one JSX source row, and the scenario row header): 496, recounted with grep -o.
    // ADR-038, Task 15 adds 6: the Gap tab's next-reset ALCO ladder table (Band, Assets, Liabilities, Gap,
    // Cumulative columns and the band row header): 502.
    // Piece B, B3b (Rate indices) adds 2: the History column of the indices table and of the preview table: 504.
    // Piece B slice two, Task 8A adds 7: the Stochastic distributions Calibration card 3 (Field, Value columns and the
    // key row header) and the Compare Calibration parameters card 4 (Parameter, Run A, Run B columns and the key row
    // header): 511.
    // Piece B slice two, Task 8B adds 5: the SABR smile card's stored points table (Strike, Stored, Model, Residual
    // columns and the strike row header): 516.
    // Slice three, Task 7 adds 1: the monthly NII table's detail column header, one JSX source tag mapped over the
    // shown series (balance, principal, interest, yield, originations): 517.
    // Slice 4b, T4 adds 11: the Stochastic Gap distributions card's table (Band, Side, Mean, SE, p5, p25, p50, p75, p95
    // and N columns, and the band row header, one JSX source table shared by both views and both tables): 528.
    // The teaching build's views (C1, C3, E1, E2, E3: 73) and the tie-out tab (8) brought it to 601;
    // OSS slice S1 moves those 81 out of this tree: 520 here, recounted with grep -o.
    // The guided Analysis path adds 46: Market 7 (snapshots 4, curve edit 3), Balance sheet 5 (families),
    // Behavior 10 (families 5, per position 5), New volume 7 (targets), Scenarios 5 (your shocks 3, knots 2), Run 3 (runs)
    // and Reports 9 (the report table 2 and the tag table 2, each a column header mapped over scenarios, and the
    // stochastic plain table 5): 566.
    // Studio slice S2b-1 adds 5 net: the New volume targets table drops its Spread and Term columns (-2, they
    // move to the product), and the products table adds 7 (Family, Rate, Repayment, Term, Priced off, Spread, Rate
    // today): 571.
    // Studio slice S2b-2 adds 1: the products table's Behavior column: 572.
    // Studio slice S2b-3 removes 2: the Reports step's own tag table goes (a tag report is a report table): 570.
    // Studio slice S3c-1 adds 20, the deposit readouts: Life by family 4 (Family, Life in years, Life in months
    // and the family row header), Deposit credits 9 (eight columns and the family row header) and its table by scenario 7
    // (six columns and the scenario row header): 590, recounted with grep -o.
    // Studio slice S3d-1 adds 66 net: the survival path's section, 54 (the calculator's 31 moved in, the run's path, the dials and the checks), and the Liquidity tab's buffer table and its CD
    // columns, 12 net: 656, recounted with grep -o.
    // S3d fix round adds 2: the dials card's "Undrawn now" and "Commitment face" rows in place of one: 658.
    expect(tags.length).toBe(658);
    expect(tags.filter((t) => !t.includes("scope="))).toEqual([]);
  });
});
