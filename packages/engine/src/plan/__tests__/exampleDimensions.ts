/**
 * The dimension rows the example plan's gates are checked over (examplePlan.test.ts): one row per position of a
 * synthetic book, each naming the product family the plan's selectors read, its side, a calibration segment and the
 * behavioral classes its family declares. Structure only: no balance, no rate, no bank.
 */
export interface ExampleDimensionRow {
  id: string;
  dims: { productFamily: string; side: string; behavioralClasses: string[]; segment: string };
}

const row = (id: string, productFamily: string, side: string, segment: string, behavioralClasses: string[]): ExampleDimensionRow => ({
  id,
  dims: { productFamily, side, segment, behavioralClasses },
});

export const EXAMPLE_DIMENSION_ROWS: readonly ExampleDimensionRow[] = [
  row("X-FIXED-1", "Fixed Loans", "Asset", "Whole book", ["prepayment"]),
  row("X-FIXED-2", "Fixed Loans", "Asset", "Whole book", ["prepayment"]),
  row("X-FLOAT-1", "Floating Loans", "Asset", "Whole book", ["draw-utilization"]),
  row("X-MORT-1", "Mortgages", "Asset", "Whole book", ["prepayment"]),
  row("X-LINE-1", "Revolving Facilities", "Off balance sheet", "Whole book", ["draw-utilization"]),
  row("X-INV-1", "Investments", "Asset", "Whole book", ["prepayment", "client-rate-asset"]),
  row("X-CASH-1", "Cash & Equivalents", "Asset", "Whole book", []),
  row("X-SAV-1", "MMA / Savings", "Liability", "Rate shoppers", ["decay", "deposit-beta"]),
  row("X-SAV-2", "MMA / Savings", "Liability", "Relationship", ["decay", "deposit-beta"]),
  row("X-DDA-1", "DDA (Non-Interest)", "Liability", "Whole book", ["decay"]),
  row("X-CD-1", "CDs", "Liability", "Whole book", ["early-withdrawal"]),
  row("X-ADV-1", "FHLB Advances", "Liability", "Whole book", []),
  row("X-EQ-1", "Equity", "Equity", "Whole book", []),
];
